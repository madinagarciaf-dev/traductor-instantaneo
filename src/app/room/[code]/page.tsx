"use client";

import { use, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

type WsMsg =
  | { type: "join"; room: string }
  | { type: "peers"; count: number; room?: string; serverId?: string }
  | { type: "hello"; serverId: string; clientId: string }
  | { type: "signal"; payload: any };

export default function RoomPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = use(params);

  const sp = useSearchParams();
  const my = sp.get("my") ?? "es";
  const peer = sp.get("peer") ?? "hu";

  const invitePath = `/room/${code}?my=${encodeURIComponent(peer)}&peer=${encodeURIComponent(my)}`;

  const [wsStatus, setWsStatus] = useState<"off" | "connecting" | "on">("off");
  const [peers, setPeers] = useState<number>(1);

  const [audioStatus, setAudioStatus] = useState<
    "idle" | "getting-mic" | "calling" | "connected" | "error"
  >("idle");
  const [audioError, setAudioError] = useState<string>("");

  const [iceState, setIceState] = useState<string>("new");
  const [connState, setConnState] = useState<string>("new");
  const [remoteReady, setRemoteReady] = useState(false);
  const [needsRemotePlay, setNeedsRemotePlay] = useState(false);

  // 🔥 Traducción (OpenAI Realtime)
  const [trStatus, setTrStatus] = useState<"idle" | "connecting" | "connected" | "error">("idle");
  const [trError, setTrError] = useState<string>("");
  const [needsTrPlay, setNeedsTrPlay] = useState(false);
  const SIGNAL_URL = process.env.NEXT_PUBLIC_SIGNAL_URL ?? "ws://localhost:3001";
  const [serverId, setServerId] = useState<string>("-");
  const [clientId, setClientId] = useState<string>("-");


  const wsRef = useRef<WebSocket | null>(null);

  // P2P (entre usuarios)
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

  // OpenAI Realtime (traducción local)
  const oaiPcRef = useRef<RTCPeerConnection | null>(null);
  const trAudioRef = useRef<HTMLAudioElement | null>(null);

  // Para “fabricar” un track local desde el audio remoto (más compatible que reusar remote track)
  const audioCtxRef = useRef<AudioContext | null>(null);
  const trSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const trDestRef = useRef<MediaStreamAudioDestinationNode | null>(null);

  // Trickle ICE buffer (por si llegan candidates antes de setRemoteDescription)
  const pendingCandidatesRef = useRef<any[]>([]);
  const remoteDescSetRef = useRef(false);
  const connectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const iceServersRef = useRef<RTCIceServer[] | null>(null);

    async function getIceServers(): Promise<RTCIceServer[]> {
    if (iceServersRef.current) return iceServersRef.current;

    const r = await fetch("/api/ice", { cache: "no-store" });
    if (!r.ok) throw new Error(`ICE servers fetch failed: ${r.status}`);

    const data = await r.json();

    // Normalizamos: RTCPeerConnection espera "urls"
    const servers: RTCIceServer[] = (data.iceServers ?? []).map((s: any) => ({
        urls: s.urls ?? s.url,              // Twilio a veces trae ambos
        username: s.username,
        credential: s.credential,
    }));

    iceServersRef.current = servers;
    return servers;
    }


  useEffect(() => {
    setWsStatus("connecting");
    const ws = new WebSocket(`${SIGNAL_URL}?room=${encodeURIComponent(code)}`);


    wsRef.current = ws;

    ws.onopen = () => {
      setWsStatus("on");
      const join: WsMsg = { type: "join", room: code };
      ws.send(JSON.stringify(join));
    };

    ws.onmessage = async (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
    if (msg.type === "hello") {
    setServerId(msg.serverId ?? "-");
    setClientId(msg.clientId ?? "-");
    return;
    }

    if (msg.type === "peers" && typeof msg.count === "number") {
    setPeers(msg.count);
    if (msg.serverId) setServerId(msg.serverId);
    return;
    }

      if (msg.type === "signal") {
        await handleSignal(msg.payload);
      }
    };

    ws.onclose = () => setWsStatus("off");
    ws.onerror = () => setWsStatus("off");

    return () => {
      ws.close();
    };
  }, [code]);

  function sendSignal(payload: any) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const msg: WsMsg = { type: "signal", payload };
    ws.send(JSON.stringify(msg));
  }

    async function ensurePeerConnection() {
    if (pcRef.current) return pcRef.current;

    const iceServers = await getIceServers();

    const pc = new RTCPeerConnection({
        iceServers,
        // Déjalo así al principio. Si aún diera problemas, luego forzamos "relay".
        iceTransportPolicy: "all",
    });

    pc.onicecandidate = (ev) => {
        if (ev.candidate) {
        console.log("ICE CANDIDATE:", ev.candidate.candidate);
        sendSignal({ kind: "ice", candidate: ev.candidate });
        }
    };

    pc.onicecandidateerror = (e) => {
        console.log("ICE ERROR:", e);
    };

    pc.oniceconnectionstatechange = () => setIceState(pc.iceConnectionState);

    pc.onconnectionstatechange = () => {
        setConnState(pc.connectionState);

        if (pc.connectionState === "connected") {
            if (connectTimeoutRef.current) {
                clearTimeout(connectTimeoutRef.current);
                connectTimeoutRef.current = null;
            }
            setAudioStatus("connected");
        }


        if (pc.connectionState === "failed") {
        setAudioStatus("error");
        setAudioError("WebRTC connection failed (ICE/TURN).");
        }
    };

    pc.ontrack = async (ev) => {
        const [stream] = ev.streams;
        const el = remoteAudioRef.current;
        if (!el) return;

        el.srcObject = stream;
        el.muted = false;
        el.volume = 1;
        setRemoteReady(true);

        try {
        await el.play();
        setNeedsRemotePlay(false);
        } catch (e) {
        console.warn("remote audio play() blocked:", e);
        setNeedsRemotePlay(true);
        }
    };

    pcRef.current = pc;
    return pc;
    }

    async function recreatePcWithRelay() {
    try {
        pcRef.current?.close();
    } catch {}
    pcRef.current = null;
    remoteDescSetRef.current = false;
    pendingCandidatesRef.current = [];

    const iceServers = await getIceServers();
    const pc = new RTCPeerConnection({
        iceServers,
        iceTransportPolicy: "relay",
    });

    // vuelve a enganchar handlers igual que en ensurePeerConnection()
    pc.onicecandidate = (ev) => {
        if (ev.candidate) sendSignal({ kind: "ice", candidate: ev.candidate });
    };
    pc.onicecandidateerror = (e) => console.log("ICE ERROR (relay):", e);
    pc.oniceconnectionstatechange = () => setIceState(pc.iceConnectionState);
    pc.onconnectionstatechange = () => {
        setConnState(pc.connectionState);
        if (pc.connectionState === "connected") {
            if (connectTimeoutRef.current) {
                clearTimeout(connectTimeoutRef.current);
                connectTimeoutRef.current = null;
            }
            setAudioStatus("connected");
            }
                    if (pc.connectionState === "failed") {
        setAudioStatus("error");
        setAudioError("WebRTC failed incluso con TURN (relay).");
        }
    };
    pc.ontrack = async (ev) => {
        const [stream] = ev.streams;
        const el = remoteAudioRef.current;
        if (!el) return;
        el.srcObject = stream;
        el.muted = false;
        el.volume = 1;
        setRemoteReady(true);
        try {
        await el.play();
        setNeedsRemotePlay(false);
        } catch {
        setNeedsRemotePlay(true);
        }
    };

    pcRef.current = pc;
    return pc;
    }



  async function startAudio() {
    try {
      setAudioError("");
      setAudioStatus("getting-mic");

      const pc = await ensurePeerConnection();

      const local = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      localStreamRef.current = local;

      for (const track of local.getAudioTracks()) {
        pc.addTrack(track, local);
      }

      // Caller determinista (evita offer-offer)
      const iAmCaller = my < peer;
      setAudioStatus("calling");
      // Limpia timeout anterior si existiera
        if (connectTimeoutRef.current) {
        clearTimeout(connectTimeoutRef.current);
        connectTimeoutRef.current = null;
        }

        connectTimeoutRef.current = setTimeout(async () => {
        if (pc.connectionState !== "connected") {
            console.log("⏱️ No conectó en 10s -> forzando TURN relay");
            const newPc = await recreatePcWithRelay();

            const local = localStreamRef.current;
            if (local) {
            for (const track of local.getAudioTracks()) newPc.addTrack(track, local);
            }

            const iAmCaller2 = my < peer;
            if (iAmCaller2) {
            const offer2 = await newPc.createOffer();
            await newPc.setLocalDescription(offer2);
            sendSignal({ kind: "offer", sdp: offer2 });
            }
        }
        }, 10000);



      if (iAmCaller) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSignal({ kind: "offer", sdp: offer });
      }
    } catch (e: any) {
      setAudioStatus("error");
      setAudioError(e?.message ?? String(e));
    }
  }

  async function handleSignal(payload: any) {
    const pc = await ensurePeerConnection();

    if (payload?.kind === "offer") {
      await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
      remoteDescSetRef.current = true;

      for (const c of pendingCandidatesRef.current) await pc.addIceCandidate(c);
      pendingCandidatesRef.current = [];

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal({ kind: "answer", sdp: answer });
      return;
    }

    if (payload?.kind === "answer") {
      await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
      remoteDescSetRef.current = true;

      for (const c of pendingCandidatesRef.current) await pc.addIceCandidate(c);
      pendingCandidatesRef.current = [];
      return;
    }

    if (payload?.kind === "ice" && payload.candidate) {
      const cand = new RTCIceCandidate(payload.candidate);
      if (!remoteDescSetRef.current) pendingCandidatesRef.current.push(cand);
      else await pc.addIceCandidate(cand);
    }
  }

  const enableRemoteAudio = async () => {
    const el = remoteAudioRef.current;
    if (!el) return;
    el.muted = false;
    try {
      await el.play();
      setNeedsRemotePlay(false);
    } catch (e) {
      console.warn("Still blocked:", e);
    }
  };

  // ============================
  // 🔥 TRADUCCIÓN (OpenAI Realtime)
  // ============================

  const startTranslation = async () => {
    try {
      setTrError("");
      setNeedsTrPlay(false);

      // Necesitamos stream remoto para traducir
      const remoteStream = remoteAudioRef.current?.srcObject as MediaStream | null;
      if (!remoteStream) throw new Error("Aún no hay audio remoto. Conecta el audio P2P primero.");

      setTrStatus("connecting");

      // 1) Token efímero (tu endpoint)
      const tokenRes = await fetch(
        `/api/realtime-token?my=${encodeURIComponent(my)}&peer=${encodeURIComponent(peer)}&voice=alloy`
      );
      const tokenData = await tokenRes.json();
      const EPHEMERAL_KEY = tokenData?.value;
      if (!EPHEMERAL_KEY) throw new Error("No llegó client_secret (ek_...) desde /api/realtime-token");

      // 2) Crear un track LOCAL desde el stream remoto (WebAudio)
      const AudioCtxCtor =
        window.AudioContext || ((window as any).webkitAudioContext as typeof AudioContext);
      const ac = audioCtxRef.current ?? new AudioCtxCtor();
      audioCtxRef.current = ac;

      if (ac.state === "suspended") await ac.resume();

      // Limpieza si reinicias
      try {
        trSourceRef.current?.disconnect();
      } catch {}

      const source = ac.createMediaStreamSource(remoteStream);
      const dest = ac.createMediaStreamDestination();
      source.connect(dest);

      trSourceRef.current = source;
      trDestRef.current = dest;

      const inputTrack = dest.stream.getAudioTracks()[0];
      if (!inputTrack) throw new Error("No se pudo obtener track de audio para traducir.");

      // 3) Conectar WebRTC con OpenAI Realtime (ephemeral token)
      const oaiPc = new RTCPeerConnection();
      oaiPcRef.current = oaiPc;

      // Reproducir audio traducido del modelo
      oaiPc.ontrack = async (e) => {
        const el = trAudioRef.current;
        if (!el) return;

        el.srcObject = e.streams[0];
        el.muted = false;
        el.volume = 1;

        // Cuando ya tenemos traducción, muteamos el audio original
        if (remoteAudioRef.current) remoteAudioRef.current.muted = true;

        try {
          await el.play();
          setNeedsTrPlay(false);
        } catch (err) {
          console.warn("translated audio play() blocked:", err);
          setNeedsTrPlay(true);
        }
      };

      // DataChannel opcional (sirve para ver eventos en consola)
      const dc = oaiPc.createDataChannel("oai-events");
      dc.addEventListener("message", (ev) => {
        try {
          console.log("OAI event:", JSON.parse(ev.data));
        } catch {
          console.log("OAI raw:", ev.data);
        }
      });

      // Añadimos el “micro” (que en realidad es el audio remoto)
      oaiPc.addTrack(inputTrack, dest.stream);

      const offer = await oaiPc.createOffer();
      await oaiPc.setLocalDescription(offer);

      // POST SDP al endpoint de calls con Bearer ephemeral key
      const sdpResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${EPHEMERAL_KEY}`,
          "Content-Type": "application/sdp",
        },
      });

      const answerSdp = await sdpResponse.text();
      await oaiPc.setRemoteDescription({ type: "answer", sdp: answerSdp });

      setTrStatus("connected");
    } catch (e: any) {
      setTrStatus("error");
      setTrError(e?.message ?? String(e));
    }
  };

  const enableTranslatedAudio = async () => {
    const el = trAudioRef.current;
    if (!el) return;
    el.muted = false;
    try {
      await el.play();
      setNeedsTrPlay(false);
    } catch (e) {
      console.warn("Still blocked:", e);
    }
  };

  const stopTranslation = async () => {
    // Cierra PC de OpenAI
    try {
      oaiPcRef.current?.close();
    } catch {}
    oaiPcRef.current = null;

    // Desconecta audio graph
    try {
      trSourceRef.current?.disconnect();
    } catch {}
    trSourceRef.current = null;
    trDestRef.current = null;

    // Rehabilita audio original
    if (remoteAudioRef.current) remoteAudioRef.current.muted = false;

    setNeedsTrPlay(false);
    setTrError("");
    setTrStatus("idle");
  };

  const copyInvite = async () => {
    const full = `${window.location.origin}${invitePath}`;
    try {
      await navigator.clipboard.writeText(full);
      alert("Enlace copiado ✅");
    } catch {
      prompt("Copia este enlace:", full);
    }
  };

  const audioLabel =
    audioStatus === "idle"
      ? "Iniciar audio"
      : audioStatus === "getting-mic"
      ? "Pidiendo micro..."
      : audioStatus === "calling"
      ? "Conectando..."
      : audioStatus === "connected"
      ? "Audio conectado ✅"
      : "Error de audio";

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 flex items-center justify-center p-6">
      <div className="w-full max-w-xl rounded-2xl bg-neutral-900/60 border border-neutral-800 p-6 shadow">
        <h1 className="text-2xl font-semibold">Sala: {code}</h1>

        <p className="text-neutral-300 mt-2">
          Tú: <span className="font-medium">{my}</span> · Otra persona:{" "}
          <span className="font-medium">{peer}</span>
        </p>

        <div className="mt-4 flex items-center justify-between rounded-xl bg-neutral-950 border border-neutral-800 p-4">
          <div className="text-sm text-neutral-300">
            Señalización:{" "}
            <span className="font-medium">
              {wsStatus === "on" ? "Conectado" : wsStatus === "connecting" ? "Conectando..." : "Desconectado"}
            </span>
          </div>
          <div className="text-sm text-neutral-300">
            Personas en sala: <span className="font-medium">{peers}</span>
          </div>
        </div>

        {/* Audio P2P */}
        <div className="mt-4 rounded-xl bg-neutral-950 border border-neutral-800 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm text-neutral-300">
              Audio P2P (WebRTC):{" "}
              <span className="font-medium">{audioStatus === "connected" ? "OK" : audioStatus}</span>
              <p className="mt-2 text-xs text-neutral-400">
                ICE: {iceState} · Conn: {connState} · Remote: {remoteReady ? "sí" : "no"}
              </p>
            </div>

            <button
              onClick={startAudio}
              disabled={audioStatus !== "idle"}
              className="rounded-xl bg-white text-neutral-950 font-medium px-4 py-2 hover:opacity-90 disabled:opacity-50"
            >
              {audioLabel}
            </button>
          </div>

          {audioStatus === "error" && <p className="mt-3 text-sm text-red-300 break-words">{audioError}</p>}

          <audio ref={remoteAudioRef} autoPlay playsInline />
          {needsRemotePlay && (
            <button
              onClick={enableRemoteAudio}
              className="mt-3 rounded-xl bg-neutral-800 border border-neutral-700 px-4 py-2 hover:bg-neutral-700"
            >
              Activar sonido
            </button>
          )}

          <p className="mt-3 text-xs text-neutral-400">
            Consejo: usa auriculares para evitar eco. Si no oyes nada, pulsa “Iniciar audio” en ambos.
          </p>
        </div>

        {/* Traducción */}
        <div className="mt-4 rounded-xl bg-neutral-950 border border-neutral-800 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm text-neutral-300">
              Traducción (OpenAI Realtime):{" "}
              <span className="font-medium">{trStatus}</span>
              <p className="mt-2 text-xs text-neutral-400">
                Traduce <span className="font-medium">{peer}</span> → <span className="font-medium">{my}</span>
              </p>
            </div>

            {trStatus === "idle" ? (
              <button
                onClick={startTranslation}
                disabled={!remoteReady}
                className="rounded-xl bg-white text-neutral-950 font-medium px-4 py-2 hover:opacity-90 disabled:opacity-50"
              >
                Iniciar traducción
              </button>
            ) : (
              <button
                onClick={stopTranslation}
                className="rounded-xl bg-neutral-800 border border-neutral-700 px-4 py-2 hover:bg-neutral-700"
              >
                Parar
              </button>
            )}
          </div>

          {trStatus === "error" && <p className="mt-3 text-sm text-red-300 break-words">{trError}</p>}

          {/* Audio traducido (del modelo) */}
          <audio ref={trAudioRef} autoPlay playsInline />
          {needsTrPlay && (
            <button
              onClick={enableTranslatedAudio}
              className="mt-3 rounded-xl bg-neutral-800 border border-neutral-700 px-4 py-2 hover:bg-neutral-700"
            >
              Activar sonido traducido
            </button>
          )}

          <p className="mt-3 text-xs text-neutral-400">
            Nota: cuando entra traducción, se mutea el audio original para que solo oigas el traducido.
          </p>
        </div>

        {/* Invitación */}
        <div className="mt-6 rounded-xl bg-neutral-950 border border-neutral-800 p-4">
          <p className="text-sm text-neutral-300">Enlace para invitar:</p>
          <p className="mt-2 break-all text-sm">{invitePath}</p>
          <button
            onClick={copyInvite}
            className="mt-3 rounded-xl bg-neutral-800 border border-neutral-700 px-4 py-2 hover:bg-neutral-700"
          >
            Copiar enlace completo
          </button>
        </div>
        <p className="mt-2 text-xs text-neutral-400">
        WS: {SIGNAL_URL} · serverId: {serverId} · clientId: {clientId}
        </p>


        <div className="mt-6">
          <a href="/" className="text-sm text-neutral-300 underline">
            Volver
          </a>
        </div>
      </div>
    </main>
  );
}
