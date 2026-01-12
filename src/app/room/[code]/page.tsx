"use client";

import { use, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

const LANGS = [
  { code: "es", label: "Español" },
  { code: "en", label: "English" },
  { code: "hu", label: "Magyar (Húngaro)" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "it", label: "Italiano" },
];

type Role = "creator" | "guest" | "unknown";

type RoomState = {
  creator: { name: string; lang: string };
  guest: { name: string; lang: string };
};

type WsMsg =
  | { type: "join"; room: string }
  | { type: "peers"; count: number; room?: string; serverId?: string }
  | { type: "hello"; serverId: string; clientId: string; role?: Role; roomState?: RoomState }
  | { type: "room_state"; roomState: RoomState }
  | { type: "init_room"; payload: RoomState }
  | { type: "profile"; payload: { name?: string; lang?: string } }
  | { type: "signal"; payload: any };

function initialsOf(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const a = parts[0]?.[0] ?? "?";
  const b = parts[1]?.[0] ?? "";
  return (a + b).toUpperCase();
}

function langLabel(code: string) {
  return LANGS.find((l) => l.code === code)?.label ?? code;
}

function ParticipantTile({
  title,
  name,
  speaking,
  translatorSpeaking,
  waitingText,
}: {
  title: string;
  name: string;
  speaking: boolean;
  translatorSpeaking?: boolean;
  waitingText?: string;
}) {
  const initials = initialsOf(name);

  return (
    <div className="rounded-3xl bg-neutral-900/60 border border-neutral-800 p-6 shadow flex flex-col items-center justify-center min-h-[320px]">
      <div className="text-sm text-neutral-400">{title}</div>

      {/* Avatar + rings */}
      <div className="mt-6 relative h-44 w-44">
        {/* Aro dorado/crema (traductor hablando) -> por fuera */}
        {translatorSpeaking && (
          <div
            className={[
              "absolute -inset-2 rounded-full pointer-events-none",
              "ring-2 ring-amber-200",
              "shadow-[0_0_35px_rgba(253,230,138,0.25)]",
              "animate-pulse",
              "z-20",
            ].join(" ")}
          />
        )}

        {/* Aro azul (hablante detectado por VAD) */}
        {speaking && (
          <div
            className={[
              "absolute inset-0 rounded-full pointer-events-none",
              "ring-4 ring-blue-400",
              "shadow-[0_0_40px_rgba(59,130,246,0.45)]",
              "animate-pulse",
              "z-10",
            ].join(" ")}
          />
        )}

        {/* Círculo base */}
        <div
          className={[
            "h-44 w-44 rounded-full flex items-center justify-center text-5xl font-semibold select-none",
            "bg-neutral-950 border border-neutral-800",
            "relative z-0",
          ].join(" ")}
        >
          {initials}
        </div>
      </div>

      <div className="mt-4 text-base text-neutral-200">{name || "Sin nombre"}</div>

      {waitingText ? (
        <div className="mt-2 text-sm text-neutral-400">{waitingText}</div>
      ) : (
        <div className="mt-2 text-sm text-neutral-500"> </div>
      )}
    </div>
  );
}


export default function RoomPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);

  const sp = useSearchParams();
  const qsMy = sp.get("my") ?? "es"; // solo para init del creador (si viene)
  const qsPeer = sp.get("peer") ?? "hu"; // solo para init del creador (si viene)
  const qsName = sp.get("name") ?? "";
  const qsPeerName = sp.get("peerName") ?? "";
  const isInitHint = sp.get("init") === "1";

  const SIGNAL_URL = process.env.NEXT_PUBLIC_SIGNAL_URL ?? "ws://localhost:3001";

  const [wsStatus, setWsStatus] = useState<"off" | "connecting" | "on">("off");
  const [peers, setPeers] = useState<number>(1);

  const [serverId, setServerId] = useState<string>("-");
  const [clientId, setClientId] = useState<string>("-");
  const [myRole, setMyRole] = useState<Role>("unknown");

  const [roomState, setRoomState] = useState<RoomState | null>(null);

  // Drafts editables (tu usuario)
  const [myNameDraft, setMyNameDraft] = useState<string>(qsName);
  const [myLangDraft, setMyLangDraft] = useState<string>("");
  const myLangTouchedRef = useRef(false);


  // Audio P2P
  const [audioStatus, setAudioStatus] = useState<"idle" | "getting-mic" | "calling" | "connected" | "error">("idle");
  const [audioError, setAudioError] = useState<string>("");

  const [iceState, setIceState] = useState<string>("new");
  const [connState, setConnState] = useState<string>("new");
  const [remoteReady, setRemoteReady] = useState(false);
  const [needsRemotePlay, setNeedsRemotePlay] = useState(false);

  // Traducción
  const [trStatus, setTrStatus] = useState<"idle" | "connecting" | "connected" | "error">("idle");
  const [trError, setTrError] = useState<string>("");
  const [needsTrPlay, setNeedsTrPlay] = useState(false);

  // speaking indicator
  const [meSpeaking, setMeSpeaking] = useState(false);
  const [otherSpeaking, setOtherSpeaking] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

  const oaiPcRef = useRef<RTCPeerConnection | null>(null);
  const trAudioRef = useRef<HTMLAudioElement | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const trSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const trDestRef = useRef<MediaStreamAudioDestinationNode | null>(null);

  const pendingCandidatesRef = useRef<any[]>([]);
  const remoteDescSetRef = useRef(false);
  const connectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const iceServersRef = useRef<RTCIceServer[] | null>(null);

  // VAD cleanup
  const vadCleanupLocalRef = useRef<null | (() => void)>(null);
  const vadCleanupRemoteRef = useRef<null | (() => void)>(null);
  const [translatorSpeaking, setTranslatorSpeaking] = useState(false);
  const vadCleanupTrRef = useRef<null | (() => void)>(null);
  
  // ✅ AÑADE ESTO AQUÍ (una sola vez)
  useEffect(() => {
    return () => {
      try { vadCleanupTrRef.current?.(); } catch {}
      vadCleanupTrRef.current = null;
    };
  }, []);

  const didInitRoomRef = useRef(false);

  async function getIceServers(): Promise<RTCIceServer[]> {
    if (iceServersRef.current) return iceServersRef.current;

    const r = await fetch("/api/ice", { cache: "no-store" });
    if (!r.ok) throw new Error(`ICE servers fetch failed: ${r.status}`);

    const data = await r.json();

    const servers: RTCIceServer[] = (data.iceServers ?? []).map((s: any) => ({
      urls: s.urls ?? s.url,
      username: s.username,
      credential: s.credential,
    }));

    iceServersRef.current = servers;
    return servers;
  }

  function sendWs(obj: WsMsg) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(obj));
  }

  function sendSignal(payload: any) {
    sendWs({ type: "signal", payload });
  }

  function setupVAD(stream: MediaStream, setSpeaking: (v: boolean) => void, threshold = 0.03) {
    try {
      const AudioCtxCtor = window.AudioContext || ((window as any).webkitAudioContext as typeof AudioContext);
      const ctx = new AudioCtxCtor();

      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);

      const data = new Uint8Array(analyser.frequencyBinCount);
      let raf = 0;

      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        setSpeaking(rms > threshold);
        raf = requestAnimationFrame(tick);
      };

      tick();

      return () => {
        try { cancelAnimationFrame(raf); } catch {}
        try { src.disconnect(); } catch {}
        try { analyser.disconnect(); } catch {}
        try { ctx.close(); } catch {}
      };
    } catch {
      return () => {};
    }
  }

  // ======= Derivados de estado de sala =======
  const me = myRole === "creator" ? roomState?.creator : myRole === "guest" ? roomState?.guest : null;
  const other = myRole === "creator" ? roomState?.guest : myRole === "guest" ? roomState?.creator : null;

  const myLangEffective = (myLangDraft || me?.lang || qsMy).trim();
  const peerLangEffective = (other?.lang || qsPeer).trim();

  const myNameEffective = (me?.name || myNameDraft || "Yo").trim() || "Yo";
  const otherNameEffective = (other?.name || (myRole === "creator" ? qsPeerName : "") || "Otra persona").trim() || "Otra persona";

  const waitingText = peers < 2 ? `Esperando a ${otherNameEffective}…` : undefined;

  // ======= WS connect =======
  useEffect(() => {
    setWsStatus("connecting");

    // SIGNAL_URL debe ser .../ws
    const ws = new WebSocket(`${SIGNAL_URL}?room=${encodeURIComponent(code)}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsStatus("on");
      sendWs({ type: "join", room: code });
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
        const role: Role = msg.role ?? "unknown";
        setMyRole(role);

        if (msg.roomState) {
          setRoomState(msg.roomState as RoomState);

          // set draft de idioma si aún no tenemos
          const myLangFromRoom =
            role === "creator" ? msg.roomState.creator?.lang : role === "guest" ? msg.roomState.guest?.lang : "";
          if (!myLangTouchedRef.current && myLangFromRoom) setMyLangDraft(myLangFromRoom);
        }

        // INIT de sala: solo lo intenta el creator (el DO ignora si ya está init)
        if (!didInitRoomRef.current && role === "creator") {
          didInitRoomRef.current = true;

          // Si vienes desde "Crear sala", esto trae idiomas + nombres
          // Si entraste por código y eres el primero (poco común), usará defaults
          const initState: RoomState = {
            creator: { name: (qsName || "Yo").trim(), lang: (qsMy || "es").trim() },
            guest: { name: (qsPeerName || "Otra persona").trim(), lang: (qsPeer || "hu").trim() },
          };

          // Solo intentamos init si hay "hint" o si no hay langs aún
          const hasLangs = Boolean(msg.roomState?.creator?.lang && msg.roomState?.guest?.lang);
          if (isInitHint || !hasLangs) {
            sendWs({ type: "init_room", payload: initState });
          }

          // y setea tu propio perfil por si el estado estaba vacío
          sendWs({ type: "profile", payload: { name: initState.creator.name, lang: initState.creator.lang } });
        }

        // Perfil del guest: manda su nombre (no pisa idioma)
        if (role === "guest") {
          if (qsName?.trim()) sendWs({ type: "profile", payload: { name: qsName.trim() } });
        }

        return;
      }

      if (msg.type === "peers" && typeof msg.count === "number") {
        setPeers(msg.count);
        if (msg.serverId) setServerId(msg.serverId);
        return;
      }

      if (msg.type === "room_state") {
        setRoomState(msg.roomState as RoomState);

        // si todavía no has tocado el selector de idioma, hidrata draft
        const nextMyLang =
          myRole === "creator" ? msg.roomState.creator?.lang : myRole === "guest" ? msg.roomState.guest?.lang : "";
        if (nextMyLang && !myLangTouchedRef.current) setMyLangDraft(nextMyLang);

        // hidrata nombre draft si viene vacío
        const nextMyName =
          myRole === "creator" ? msg.roomState.creator?.name : myRole === "guest" ? msg.roomState.guest?.name : "";
        if (nextMyName && !myNameDraft) setMyNameDraft(nextMyName);

        return;
      }

      if (msg.type === "signal") {
        await handleSignal(msg.payload);
      }
    };

    ws.onclose = () => setWsStatus("off");
    ws.onerror = () => setWsStatus("off");

    return () => {
      try {
        ws.close();
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // ======= PeerConnection =======
  async function ensurePeerConnection() {
    if (pcRef.current) return pcRef.current;

    const iceServers = await getIceServers();

    const pc = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: "all",
    });

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
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

      // remote VAD
      try {
        vadCleanupRemoteRef.current?.();
      } catch {}
      vadCleanupRemoteRef.current = setupVAD(stream, setOtherSpeaking);

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
        vadCleanupRemoteRef.current?.();
      } catch {}
      vadCleanupRemoteRef.current = setupVAD(stream, setOtherSpeaking);

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

      // local VAD
      try {
        vadCleanupLocalRef.current?.();
      } catch {}
      vadCleanupLocalRef.current = setupVAD(local, setMeSpeaking);

      for (const track of local.getAudioTracks()) {
        pc.addTrack(track, local);
      }

      const iAmCaller = myLangEffective < peerLangEffective; // determinista
      if (!iAmCaller && (remoteDescSetRef.current || pc.connectionState === "connected")) {
        sendSignal({ kind: "need_offer" });
      }
      setAudioStatus("calling");

      if (connectTimeoutRef.current) {
        clearTimeout(connectTimeoutRef.current);
        connectTimeoutRef.current = null;
      }

      connectTimeoutRef.current = setTimeout(async () => {
        if (pc.connectionState !== "connected") {
          console.log("⏱️ No conectó en 10s -> forzando TURN relay");
          const newPc = await recreatePcWithRelay();

          const local2 = localStreamRef.current;
          if (local2) {
            for (const track of local2.getAudioTracks()) newPc.addTrack(track, local2);
          }

          const iAmCaller2 = myLangEffective < peerLangEffective;
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

    if (payload?.kind === "need_offer") {
      const iAmCaller = myLangEffective < peerLangEffective;
      if (iAmCaller) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSignal({ kind: "offer", sdp: offer });
      }
      return;
    }

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

  // ======= Traducción OpenAI =======
  const startTranslation = async () => {
    try {
      setTrError("");
      setNeedsTrPlay(false);

      const remoteStream = remoteAudioRef.current?.srcObject as MediaStream | null;
      if (!remoteStream) throw new Error("Aún no hay audio remoto. Conecta el audio P2P primero.");
      setTranslatorSpeaking(false);
      setTrStatus("connecting");

      const tokenRes = await fetch(
        `/api/realtime-token?my=${encodeURIComponent(myLangEffective)}&peer=${encodeURIComponent(peerLangEffective)}&voice=alloy`
      );
      const tokenData = await tokenRes.json();
      const EPHEMERAL_KEY = tokenData?.value;
      if (!EPHEMERAL_KEY) throw new Error("No llegó client_secret (ek_...) desde /api/realtime-token");

      const AudioCtxCtor = window.AudioContext || ((window as any).webkitAudioContext as typeof AudioContext);
      const ac = audioCtxRef.current ?? new AudioCtxCtor();
      audioCtxRef.current = ac;

      if (ac.state === "suspended") await ac.resume();

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

      const oaiPc = new RTCPeerConnection();
      oaiPcRef.current = oaiPc;

      oaiPc.ontrack = async (e) => {
        const el = trAudioRef.current;
        if (!el) return;

        el.srcObject = e.streams[0];
        el.muted = false;
        el.volume = 1;

        // ✅ aro dorado cuando el traductor habla
        try { vadCleanupTrRef.current?.(); } catch {}
        vadCleanupTrRef.current = setupVAD(e.streams[0], setTranslatorSpeaking, 0.02);

        if (remoteAudioRef.current) remoteAudioRef.current.muted = true;

        try {
          await el.play();
          setNeedsTrPlay(false);
        } catch (err) {
          console.warn("translated audio play() blocked:", err);
          setNeedsTrPlay(true);
        }
      };


      const dc = oaiPc.createDataChannel("oai-events");
      dc.addEventListener("message", (ev) => {
        try {
          console.log("OAI event:", JSON.parse(ev.data));
        } catch {
          console.log("OAI raw:", ev.data);
        }
      });

      oaiPc.addTrack(inputTrack, dest.stream);

      const offer = await oaiPc.createOffer();
      await oaiPc.setLocalDescription(offer);

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
    try {
      oaiPcRef.current?.close();
    } catch {}
    oaiPcRef.current = null;

    try {
      trSourceRef.current?.disconnect();
    } catch {}
    trSourceRef.current = null;
    trDestRef.current = null;
    try { 
      vadCleanupTrRef.current?.(); 
    } catch {}
    vadCleanupTrRef.current = null;
    setTranslatorSpeaking(false);


    if (remoteAudioRef.current) remoteAudioRef.current.muted = false;

    setNeedsTrPlay(false);
    setTrError("");
    setTrStatus("idle");
  };

  const copyInvite = async () => {
    const full = `${window.location.origin}/room/${code}`;
    try {
      await navigator.clipboard.writeText(full);
      alert("Enlace copiado ✅");
    } catch {
      prompt("Copia este enlace:", full);
    }
  };

  // ======= Guardar perfil (tu nombre / tu idioma) =======
  const saveMyName = () => {
    const v = myNameDraft.trim();
    setMyNameDraft(v);
    sendWs({ type: "profile", payload: { name: v } });
  };

  const onChangeMyLang = (v: string) => {
    myLangTouchedRef.current = true;  // ✅ IMPORTANTE
    setMyLangDraft(v);

    if (trStatus === "idle") {
      sendWs({ type: "profile", payload: { lang: v } });
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
    <main className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col">
      {/* Top bar */}
      <header className="px-6 py-4 border-b border-neutral-800 flex items-center justify-between gap-4">
        <div>
          <div className="text-lg font-semibold">Sala {code}</div>
          <div className="text-xs text-neutral-400">
            Señalización: {wsStatus} · Personas: {peers} · ICE: {iceState} · Conn: {connState}
          </div>
        </div>

        <button
          onClick={copyInvite}
          className="rounded-xl bg-neutral-800 border border-neutral-700 px-4 py-2 hover:bg-neutral-700"
        >
          Copiar enlace
        </button>
      </header>

      {/* Tiles */}
      <section className="flex-1 p-6 flex items-center justify-center">
        <div className={`w-full max-w-5xl grid gap-6 ${peers >= 2 ? "grid-cols-1 md:grid-cols-2" : "grid-cols-1"}`}>
          <ParticipantTile
            title="Yo"
            name={myNameEffective}
            speaking={meSpeaking}
            translatorSpeaking={false}
            waitingText={waitingText}
          />


          {peers >= 2 && (
            <ParticipantTile title="Otro" name={otherNameEffective} speaking={otherSpeaking} translatorSpeaking={trStatus === "connected" && translatorSpeaking} />
          )}
        </div>
      </section>

      {/* Controls */}
      <footer className="px-6 py-5 border-t border-neutral-800 bg-neutral-950/60">
        <div className="flex flex-col gap-4">
          {/* Row buttons */}
          <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
            <div className="flex gap-3">
              <button
                onClick={startAudio}
                disabled={audioStatus === "getting-mic" || Boolean(localStreamRef.current)}
                className="rounded-xl bg-white text-neutral-950 font-medium px-4 py-2 hover:opacity-90 disabled:opacity-50"
              >
                {audioLabel}
              </button>

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
                  Parar traducción
                </button>
              )}
            </div>

            <div className="text-sm text-neutral-300">
              Traducción: <span className="font-medium">{trStatus}</span>{" "}
              <span className="text-neutral-500">
                ({langLabel(peerLangEffective)} → {langLabel(myLangEffective)})
              </span>
            </div>
          </div>

          {/* Errors */}
          {audioStatus === "error" && <div className="text-sm text-red-300 break-words">{audioError}</div>}
          {trStatus === "error" && <div className="text-sm text-red-300 break-words">{trError}</div>}

          {/* Settings */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
            <div>
              <label className="block text-xs text-neutral-400 mb-1">Tu nombre</label>
              <input
                value={myNameDraft}
                onChange={(e) => setMyNameDraft(e.target.value)}
                placeholder="Tu nombre"
                className="w-full rounded-xl bg-neutral-900 border border-neutral-800 p-3"
              />
            </div>

            <button
              onClick={saveMyName}
              className="rounded-xl bg-neutral-800 border border-neutral-700 px-4 py-3 hover:bg-neutral-700"
            >
              Guardar nombre
            </button>

            <div>
              <label className="block text-xs text-neutral-400 mb-1">Tu idioma (cambia antes de traducir)</label>
              <select
                value={myLangEffective}
                onChange={(e) => onChangeMyLang(e.target.value)}
                disabled={trStatus !== "idle"}
                className="w-full rounded-xl bg-neutral-900 border border-neutral-800 p-3 disabled:opacity-60"
              >
                {LANGS.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Audio elements (hidden but needed) */}
          <audio ref={remoteAudioRef} autoPlay playsInline />
          <audio ref={trAudioRef} autoPlay playsInline />

          {needsRemotePlay && (
            <button
              onClick={enableRemoteAudio}
              className="mt-2 rounded-xl bg-neutral-800 border border-neutral-700 px-4 py-2 hover:bg-neutral-700"
            >
              Activar sonido
            </button>
          )}

          {needsTrPlay && (
            <button
              onClick={enableTranslatedAudio}
              className="mt-2 rounded-xl bg-neutral-800 border border-neutral-700 px-4 py-2 hover:bg-neutral-700"
            >
              Activar sonido traducido
            </button>
          )}

          <div className="text-xs text-neutral-500">
            WS: {SIGNAL_URL} · serverId: {serverId} · clientId: {clientId} · role: {myRole}
          </div>
        </div>
      </footer>
    </main>
  );
}
