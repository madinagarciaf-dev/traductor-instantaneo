"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

const LANGS = [
  { code: "es", label: "Español" },
  { code: "en", label: "English" },
  { code: "hu", label: "Magyar (Húngaro)" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "it", label: "Italiano" },
];

function randomRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

export default function Home() {
  const router = useRouter();
  const [myLang, setMyLang] = useState("es");
  const [peerLang, setPeerLang] = useState("hu");
  const [joinCode, setJoinCode] = useState("");

  const shareText = useMemo(() => {
    return `Mi idioma: ${myLang} | Tu idioma: ${peerLang}`;
  }, [myLang, peerLang]);

  const createRoom = () => {
    const code = randomRoomCode();
    router.push(`/room/${code}?my=${encodeURIComponent(myLang)}&peer=${encodeURIComponent(peerLang)}`);
  };

  const joinRoom = () => {
    const code = joinCode.trim().toUpperCase();
    if (!code) return;
    router.push(`/room/${code}?my=${encodeURIComponent(myLang)}&peer=${encodeURIComponent(peerLang)}`);
  };

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 flex items-center justify-center p-6">
      <div className="w-full max-w-xl rounded-2xl bg-neutral-900/60 border border-neutral-800 p-6 shadow">
        <h1 className="text-2xl font-semibold">Traductor instantáneo (MVP)</h1>
        <p className="text-neutral-300 mt-2">
          Prueba sin login. Crea una sala, comparte el código y entra desde otro móvil.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-6">
          <div>
            <label className="block text-sm text-neutral-300 mb-2">Mi idioma</label>
            <select
              value={myLang}
              onChange={(e) => setMyLang(e.target.value)}
              className="w-full rounded-xl bg-neutral-950 border border-neutral-800 p-3"
            >
              {LANGS.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm text-neutral-300 mb-2">Idioma de la otra persona</label>
            <select
              value={peerLang}
              onChange={(e) => setPeerLang(e.target.value)}
              className="w-full rounded-xl bg-neutral-950 border border-neutral-800 p-3"
            >
              {LANGS.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-6 flex flex-col sm:flex-row gap-3">
          <button
            onClick={createRoom}
            className="flex-1 rounded-xl bg-white text-neutral-950 font-medium py-3 hover:opacity-90"
          >
            Crear sala
          </button>

          <div className="flex-1 flex gap-2">
            <input
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
              placeholder="Código (ej. 7KQ2ZM)"
              className="w-full rounded-xl bg-neutral-950 border border-neutral-800 p-3"
            />
            <button
              onClick={joinRoom}
              className="rounded-xl bg-neutral-800 border border-neutral-700 px-4 hover:bg-neutral-700"
            >
              Unirme
            </button>
          </div>
        </div>

        <p className="text-xs text-neutral-400 mt-4">{shareText}</p>
      </div>
    </main>
  );
}
