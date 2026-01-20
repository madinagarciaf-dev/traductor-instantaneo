import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Falta OPENAI_API_KEY en variables de entorno (Vercel/.env.local)" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }

  const { searchParams } = new URL(req.url);
  const my = (searchParams.get("my") ?? "es").trim();
  const peer = (searchParams.get("peer") ?? "hu").trim();
  const voice = (searchParams.get("voice") ?? "alloy").trim();

  // ✅ Este endpoint te permite setear create_response/interrupt_response en server_vad
  //    (clave para tu cola/backlog). :contentReference[oaicite:3]{index=3}
  const body = {
    expires_after: { anchor: "created_at", seconds: 600 }, // 10 min (mejor que 1 min de /sessions)
    session: {
      type: "realtime",
      model: "gpt-realtime",
      instructions: `Eres un intérprete simultáneo.
El hablante habla en ${peer}.
Responde SIEMPRE en ${my}.
Traduce fielmente y en el mismo orden.
NO añadas comentarios, NO respondas como asistente, SOLO traduce.`,

      // Audio config (nuevo schema recomendado en client_secrets)
      audio: {
        input: {
          // ✅ Transcripción del audio entrante (para tu panel y eventos)
          transcription: {
            model: "whisper-1",
            language: peer, // ISO-639-1 mejora latencia/precisión
            prompt: "",
          },
          // ✅ VAD server-side pero SIN auto-responder: tú disparas response.create
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 200,
            create_response: false,
            interrupt_response: false,
          },
        },
        output: {
          voice,
        },
      },
    },
  };

  try {
    const r = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });

    const data = await r.json();

    if (!r.ok) {
      console.error("OpenAI client_secrets error:", data);
      return NextResponse.json(
        { error: "OpenAI error (client_secrets)", details: data },
        { status: r.status, headers: { "Cache-Control": "no-store" } }
      );
    }

    // ✅ Mantén el contrato exacto que tu frontend ya usa: tokenData.value
    // client_secrets responde con { value: "ek_...", ... } :contentReference[oaicite:4]{index=4}
    return NextResponse.json(
      { value: data.value },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e: any) {
    console.error("realtime-token route exception:", e);
    return NextResponse.json(
      { error: "Route exception", details: String(e?.message ?? e) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
